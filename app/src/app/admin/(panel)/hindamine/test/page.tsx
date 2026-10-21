import type { Metadata } from "next";
import Link from "next/link";
import { adminTitle } from "@/components/admin/sections";
import { TestReview } from "@/components/admin/TestReview";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { attemptForReview, attemptsOf, type ReviewAttempt } from "@/db/queries/assessment";
import { adminEt } from "@/i18n/dict/admin";
import { pick, type I18n } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";
import styles from "../assessment.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.assessment) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
/** "19.10.2026 11:00" in Tallinn. */
const stamp = (d: Date) => `${formatDate(d, "et")} ${formatTime(d, "et")}`;

/**
 * The test review (e-course completion, spec §5.4). ?id=<attempt>: one attempt — its copy of the questions, the choice part read-only and the
 * open answers' form while it waits for Maria (TestReview; its notice links here). ?ligipaas=<access>: every attempt of that student, newest
 * first, each with its result (the drawer's "Testi katsed"). Nothing found (or an access an admin ended): one sentence and the way back.
 */
export default async function TestReviewPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const attemptId = parseRowId(one(sp.id));
  const accessId = attemptId === null ? parseRowId(one(sp.ligipaas)) : null;
  const db = getDb();
  const [attempt, list] = await Promise.all([attemptId === null ? null : attemptForReview(db, attemptId), accessId === null ? null : attemptsOf(db, accessId)]);
  const t = adminEt.assessment.review;

  return (
    <div className={ui.page} data-test-review-page="">
      <p className={styles.back}>
        <Link className={ui.link} href="/admin/hindamine">
          <span aria-hidden="true">←</span> {t.back}
        </Link>
      </p>
      {attempt ? (
        <OneAttempt a={attempt} />
      ) : list && accessId !== null ? (
        <AttemptList accessId={accessId} name={list.name} course={list.course} attempts={list.attempts} />
      ) : (
        <p className={ui.empty}>{accessId === null ? t.notFound : t.notFoundAccess}</p>
      )}
    </div>
  );
}

/** One attempt: who, which try, when, its state and the choice part's score; then the review itself. */
function OneAttempt({ a }: { a: ReviewAttempt }) {
  const t = adminEt.assessment;
  const hasChoice = a.questions.some((q) => q.kind === "choice");
  return (
    <>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{pick(a.course, "et")}</p>
          <h1 className={ui.h1}>{a.name}</h1>
          <p className={ui.lead}>
            {[fill(t.tryOf, { n: a.number, max: a.allowed }), fill(t.sentAt, { date: stamp(a.submittedAt) })].join(" · ")} ·{" "}
            <span data-attempt-status={a.status}>{t.review.status[a.status]}</span>
          </p>
          {hasChoice && (
            <p className={styles.score} data-review-score="">
              {fill(t.review.score, { percent: a.percent, pass: a.passPercent })}
            </p>
          )}
        </div>
      </div>
      <TestReview attempt={{ id: a.id, status: a.status, questions: a.questions, answers: a.answers, review: a.review, submittedAt: a.submittedAt.toISOString() }} t={t.review} />
      <p className={styles.more}>
        <Link className={ui.link} href={`/admin/hindamine/test?ligipaas=${a.accessId}`}>
          {t.attempts}
        </Link>
      </p>
    </>
  );
}

/** Every attempt of one student, newest first: the try, when, the score and the state, and the way to it. */
function AttemptList({ accessId, name, course, attempts }: { accessId: number; name: string; course: I18n; attempts: ReviewAttempt[] }) {
  const t = adminEt.assessment;
  return (
    <>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{pick(course, "et")}</p>
          <h1 className={ui.h1}>{name}</h1>
          <p className={ui.lead}>{t.review.list}</p>
        </div>
      </div>
      <section className={ui.card} aria-label={t.review.list} data-attempts={accessId}>
        {attempts.length === 0 ? (
          <p className={ui.empty}>{t.review.noAttempts}</p>
        ) : (
          <ul className={styles.items}>
            {attempts.map((a) => (
              <li key={a.id} className={styles.item} data-attempt={a.id}>
                <span className={styles.what}>
                  <strong>{fill(t.tryOf, { n: a.number, max: a.allowed })}</strong>
                  <span className={ui.muted}>{[stamp(a.submittedAt), fill(t.review.percent, { n: a.percent }), t.review.status[a.status]].join(" · ")}</span>
                </span>
                <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/hindamine/test?id=${a.id}`}>
                  {t.review.view}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
