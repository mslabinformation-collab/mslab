import type { Metadata } from "next";
import Link from "next/link";
import { AssessmentQueue, QueueStatus } from "@/components/admin/AssessmentQueue";
import { assessmentTabs } from "@/components/admin/assessment-tabs";
import { ReopenTest } from "@/components/admin/ReopenTest";
import { adminTitle } from "@/components/admin/sections";
import { TabPills } from "@/components/admin/TabPills";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { assessmentList, type AssessmentItem } from "@/db/queries/assessment";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDayMonth, formatTime } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import styles from "./assessment.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.assessment) };

/** "20.10 18:35" in Tallinn (the prototype's row meta). */
const stamp = (d: Date) => `${formatDayMonth(d, "et")} ${formatTime(d, "et")}`;

/** A row's mark in the list: the practical work and the tries used are an access's, a test answer is an attempt's. */
const rowKey = (i: AssessmentItem) => (i.kind === "test" ? `test-${i.attemptId}` : `${i.kind}-${i.accessId}`);

/** The row's second line (the prototype's; P-6 for the third kind). */
function meta(i: AssessmentItem): string {
  const m = adminEt.assessment.meta;
  if (i.kind === "practical") return fill(m.practical, { n: i.round ?? 0, date: stamp(i.at) });
  if (i.kind === "test") return fill(m.test, { n: i.number ?? 0, max: i.allowed ?? 0, date: stamp(i.at) });
  return fill(m.triesUsed, { best: i.best ?? 0, attempts: i.attempts ?? 0 });
}

/**
 * Hindamine (e-course completion, spec §5.2; admin UX pass A4): what waits for Maria as one list, oldest first, under the tabs „Ootab hindamist {n}“
 * and „Tunnistused“ (the register, /admin/tunnistused, which is not in the menu). A row is „{name} · {praktiline töö | testi vastus | katsed
 * otsas}“ with its meta and its ways on: „Hinda“ (ink) opens the access's protocol screen (?ligipaas=), „Vaata“ the open answers
 * (/admin/hindamine/test?id=), and for a student out of tries „Testi katsed“ and „Ava test uuesti“ (asking with a ConfirmPanel). When nothing waits:
 * „Hindamist ootavaid töid pole.“ The page is AssessmentQueue's: a reopened test's row leaves the list on the refresh, and the status line and the
 * focus (the next row, else the heading) are the page's (ledger L99).
 */
export default async function AssessmentPage() {
  await requireAdmin();
  const items = await assessmentList(getDb());
  const t = adminEt.assessment;
  const reopen = { ...t.reopen, saving: adminEt.common.saving, error: adminEt.common.saveError };

  return (
    <AssessmentQueue>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={`${ui.h1} ${styles.title}`} tabIndex={-1} data-assessment-heading="">
            {t.title}
          </h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
      </div>

      <TabPills label={t.title} tabs={assessmentTabs("waiting", items.length)} />
      <QueueStatus />

      <section className={ui.card} aria-label={t.title}>
        {items.length === 0 ? (
          <p className={ui.empty} data-queue-empty="">
            {t.empty}
          </p>
        ) : (
          <ul className={styles.items}>
            {items.map((i) => (
              <li key={rowKey(i)} className={styles.item} data-queue-row={rowKey(i)} data-queue-item={i.accessId} data-queue-kind={i.kind}>
                <span className={styles.queueWhat}>
                  <strong>{fill(t.row, { name: i.name, kind: t.kinds[i.kind] })}</strong>
                  <span className={ui.muted}>{meta(i)}</span>
                </span>
                {i.kind === "practical" && (
                  <Link className={`${ui.btn} ${ui.smallBtn}`} href={`/admin/protokollid?ligipaas=${i.accessId}`}>
                    {t.assess}
                  </Link>
                )}
                {i.kind === "test" && (
                  <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/hindamine/test?id=${i.attemptId}`}>
                    {t.review.view}
                  </Link>
                )}
                {i.kind === "triesUsed" && (
                  <>
                    <Link className={ui.link} href={`/admin/hindamine/test?ligipaas=${i.accessId}`}>
                      {t.attempts}
                    </Link>
                    <ReopenTest accessId={i.accessId} course={i.course} used t={reopen} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AssessmentQueue>
  );
}
