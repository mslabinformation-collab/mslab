import type { Metadata } from "next";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import { ReopenTest } from "@/components/admin/ReopenTest";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { assessmentQueue } from "@/db/queries/assessment";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import styles from "./assessment.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.assessment) };

/** "19.10.2026 11:00" in Tallinn. */
const stamp = (d: Date) => `${formatDate(d, "et")} ${formatTime(d, "et")}`;

/**
 * Hindamine (e-course completion, spec §5.2): what waits for Maria, in three groups, each oldest first — the practical work sent ("Hinda" opens
 * the access's protocol screen, ?ligipaas=), the open answers waiting for her review ("Vaata vastuseid": /admin/hindamine/test?id=), and the
 * students out of tries ("Ava test uuesti" with its confirmation, and their attempts). A group with nothing in it is left out; when nothing waits
 * at all: "Kõik on hinnatud." Each group has an anchor the overview's card links to.
 */
export default async function AssessmentPage() {
  const email = await requireAdmin();
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [queue] = await Promise.all([assessmentQueue(getDb()), getAdminCounts()]);
  const t = adminEt.assessment;
  const reopen = { ...t.reopen, saving: adminEt.common.saving, error: adminEt.common.saveError };
  const nothing = queue.practicals.length + queue.tests.length + queue.triesUsed.length === 0;

  return (
    <Shell email={email} active="assessment">
      <div className={ui.page} data-assessment-page="">
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
        </div>

        {nothing ? (
          <section className={ui.card} aria-label={t.title}>
            <p className={ui.empty} data-queue-empty="">
              {t.empty}
            </p>
          </section>
        ) : (
          <div className={styles.groups}>
            {queue.practicals.length > 0 && (
              <section id="praktilised" className={ui.card} aria-labelledby="queue-practicals" data-queue="practicals">
                <h2 id="queue-practicals" className={ui.h2}>
                  {t.groups.practicals}
                </h2>
                <ul className={styles.items}>
                  {queue.practicals.map((p) => (
                    <li key={p.accessId} className={styles.item} data-queue-item={p.accessId}>
                      <span className={styles.what}>
                        <strong>{p.name}</strong>
                        <span className={ui.muted}>{[pick(p.course, "et"), fill(t.round, { n: p.round }), fill(t.sentAt, { date: stamp(p.submittedAt) })].join(" · ")}</span>
                      </span>
                      <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?ligipaas=${p.accessId}`}>
                        {t.assess}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {queue.tests.length > 0 && (
              <section id="testid" className={ui.card} aria-labelledby="queue-tests" data-queue="tests">
                <h2 id="queue-tests" className={ui.h2}>
                  {t.groups.tests}
                </h2>
                <ul className={styles.items}>
                  {queue.tests.map((w) => (
                    <li key={w.attemptId} className={styles.item} data-queue-item={w.accessId}>
                      <span className={styles.what}>
                        <strong>{w.name}</strong>
                        <span className={ui.muted}>
                          {[pick(w.course, "et"), fill(t.tryOf, { n: w.number, max: w.allowed }), fill(t.sentAt, { date: stamp(w.submittedAt) })].join(" · ")}
                        </span>
                      </span>
                      <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/hindamine/test?id=${w.attemptId}`}>
                        {t.viewAnswers}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {queue.triesUsed.length > 0 && (
              <section id="katsed" className={ui.card} aria-labelledby="queue-tries" data-queue="tries">
                <h2 id="queue-tries" className={ui.h2}>
                  {t.groups.triesUsed}
                </h2>
                <ul className={styles.items}>
                  {queue.triesUsed.map((u) => (
                    <li key={u.accessId} className={styles.item} data-queue-item={u.accessId}>
                      <span className={styles.what}>
                        <strong>{u.name}</strong>
                        <span className={ui.muted}>{[pick(u.course, "et"), fill(t.best, { n: u.best }), fill(t.attemptsMade, { n: u.attempts })].join(" · ")}</span>
                      </span>
                      <div className={styles.actions}>
                        <Link className={ui.link} href={`/admin/hindamine/test?ligipaas=${u.accessId}`}>
                          {t.attempts}
                        </Link>
                        <ReopenTest accessId={u.accessId} course={pick(u.course, "et")} used t={reopen} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}
